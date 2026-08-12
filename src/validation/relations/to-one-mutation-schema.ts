import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ObjectOptions, ObjectSchema } from "../primitives/object";
import v from "../primitives/v";
import type { InferInput, InferOutput } from "../types";
import { isRecord } from "../value-guards";

type MutationKey<T> = Extract<keyof T, string>;

type InactiveMutationValue<T> = false extends T ? false : never;

type EmptyMutation<T> = {
  [Key in MutationKey<T>]?: InactiveMutationValue<T[Key]>;
};

type MutationArm<T, Active extends MutationKey<T>> = {
  [Key in Active]-?: Exclude<T[Key], undefined>;
} & {
  [Key in Exclude<MutationKey<T>, Active>]?: InactiveMutationValue<T[Key]>;
};

/**
 * EXACTLY one active intent — the arms without the empty one.
 *
 * This is the whole type-level content of the `exactlyOne` composition mode. A
 * surface that carries its target discriminator INSIDE each verb payload (the direct
 * polymorphic edge) has no coherent reading of an empty payload and no reading at all
 * of two intents, because the storage pair it writes is atomic: one `(type, id)`.
 */
type ExactlyOneMutation<T> = {
  [Key in MutationKey<T>]: MutationArm<T, Key>;
}[MutationKey<T>];

type AtMostOneMutation<T> = EmptyMutation<T> | ExactlyOneMutation<T>;

/**
 * ONE composition, spelled as the arm that activates every key it names — and `never`
 * when the surface does not own ALL of them.
 *
 * That collapse is the only gate the composition alternatives need besides the
 * direction flag: the create root owns neither `update` nor a vacate key, an inverse
 * whose foreign key cannot be nulled owns no `disconnect`, and a required relation owns
 * neither vacate. Each of those surfaces silently loses exactly the alternatives it
 * cannot spell, with no second conditional and no per-surface list.
 */
type ComposedMutation<T, Keys extends string> = Exclude<
  Keys,
  MutationKey<T>
> extends never
  ? MutationArm<T, Extract<Keys, MutationKey<T>>>
  : never;

type VacateThenSupplyMutation<
  T,
  Vacate extends string,
  Supply extends string,
> = ComposedMutation<T, Vacate | Supply>;

type SupplyThenModifyMutation<T, Supply extends string> = ComposedMutation<
  T,
  Supply | "update"
>;

type VacateSupplyThenModifyMutation<
  T,
  Vacate extends string,
  Supply extends string,
> = ComposedMutation<T, Vacate | Supply | "update">;

/**
 * The five accepted replacements: one vacate, then one supplier. `delete` beside
 * `connectOrCreate` is the sixth pair the accepted set has never contained, kept out
 * deliberately rather than by omission — it is pinned as a refusal in
 * `parity-h-to-one-lattice.test.ts` and in `vacate-then-supply-behavior.ts`, and the
 * engine's own positional `isVacateThenSupply` excludes the same pair.
 */
type ReplacementMutation<T> =
  | VacateThenSupplyMutation<T, "disconnect", "connectOrCreate">
  | VacateThenSupplyMutation<T, "disconnect", "connect">
  | VacateThenSupplyMutation<T, "disconnect", "create">
  | VacateThenSupplyMutation<T, "delete", "connect">
  | VacateThenSupplyMutation<T, "delete", "create">;

/** The same five replacements, each composed with a modify of the supplied target. */
type ReplacementThenModifyMutation<T> =
  | VacateSupplyThenModifyMutation<T, "disconnect", "connectOrCreate">
  | VacateSupplyThenModifyMutation<T, "disconnect", "connect">
  | VacateSupplyThenModifyMutation<T, "disconnect", "create">
  | VacateSupplyThenModifyMutation<T, "delete", "connect">
  | VacateSupplyThenModifyMutation<T, "delete", "create">;

/**
 * A child-held edge composes freely: the child row carries the foreign key, so the
 * supplier's own identity is what a following `update` addresses, and a vacate before
 * it touches a DIFFERENT row.
 */
type ChildHeldCompositionMutation<T> =
  | ReplacementMutation<T>
  | SupplyThenModifyMutation<T, "create">
  | SupplyThenModifyMutation<T, "connect">
  | SupplyThenModifyMutation<T, "connectOrCreate">
  | ReplacementThenModifyMutation<T>;

/**
 * A parent-held edge composes into ONE final foreign-key value on the record's own
 * root statement, which is what limits the set: a vacate and a supplier fold to the
 * supplier's value, and `connect` is the one supplier whose target is already
 * identified when the modify has to correlate. `create` and `connectOrCreate` beside
 * `update` would have to modify a row whose identity the same statement is still
 * producing; that composition is refused here rather than half-supported.
 *
 * The CHILD-held direction admits those same two shapes and lets the engine's
 * composition owner refuse them, in a sentence that names the missing produced-identity
 * channel. The obstacle is the same one; the two directions state it in different places
 * because only this one can be seen from the payload alone — a parent-held supplier and
 * its modify fold into the record's own root statement, so "the identity is not there
 * yet" is a property of the shape, while on the child-held direction it is a property of
 * how that engine locates a selected record, and the day that channel lands only the
 * engine's sentence should have to go. Anyone widening one direction should read the
 * other's owner before assuming they agree.
 */
type ParentHeldCompositionMutation<T> =
  | ReplacementMutation<T>
  | SupplyThenModifyMutation<T, "connect">;

/**
 * Which composition rule this surface publishes. `lattice` is the accepted-set rule
 * every ordinary and inverse to-one edge uses; `exactlyOne` is the strictly narrower
 * one — no empty payload, no composition — and it exists because a direct
 * polymorphic payload has neither reading. There is no third rule and no way to
 * spell one: a surface picks one of these two.
 */
export type ToOneMutationComposition = "lattice" | "exactlyOne";

type ToOneMutationInputValue<
  T,
  ChildHeld extends boolean,
  Composition extends ToOneMutationComposition,
> = T extends object
  ? Composition extends "exactlyOne"
    ? ExactlyOneMutation<T>
    :
        | AtMostOneMutation<T>
        | (ChildHeld extends true
            ? ChildHeldCompositionMutation<T>
            : ParentHeldCompositionMutation<T>)
  : T;

type BaseObjectSchema<
  Entries,
  Options extends ObjectOptions | undefined,
> = ObjectSchema<Entries, Options>;

type ToOneMutationInput<
  Entries,
  Options extends ObjectOptions | undefined,
  ChildHeld extends boolean,
  Composition extends ToOneMutationComposition,
> = ToOneMutationInputValue<
  InferInput<BaseObjectSchema<Entries, Options>>,
  ChildHeld,
  Composition
>;

type ToOneMutationOutput<
  Entries,
  Options extends ObjectOptions | undefined,
> = InferOutput<BaseObjectSchema<Entries, Options>>;

/** A to-one mutation object with its allowed active-operation lattice. */
export interface ToOneMutationSchema<
  Entries extends object,
  Options extends ObjectOptions | undefined = undefined,
  ChildHeld extends boolean = false,
  Composition extends ToOneMutationComposition = "lattice",
> extends ObjectSchema<
    Entries,
    Options,
    ToOneMutationInput<Entries, Options, ChildHeld, Composition>,
    ToOneMutationOutput<Entries, Options>
  > {}

const VACATE_KINDS: ReadonlySet<string> = new Set(["disconnect", "delete"]);

const SUPPLY_KINDS: ReadonlySet<string> = new Set([
  "create",
  "connect",
  "connectOrCreate",
]);

/**
 * The runtime half of the lattice the types above describe, decided from the ACTIVE
 * keys alone. Each refusal below is one of the plan's continuing restrictions:
 * supplier plus supplier (two identities, one slot), `upsert` beside another target
 * intent (its own two arms already decide the target), a vacate with no supplier to
 * follow it, and two vacates.
 */
function isAcceptedComposition(
  active: readonly string[],
  childHeld: boolean
): boolean {
  if (active.length <= 1) return true;

  let vacate: string | undefined;
  let supply: string | undefined;
  let modify = false;
  for (const key of active) {
    if (VACATE_KINDS.has(key)) {
      if (vacate !== undefined) return false;
      vacate = key;
    } else if (SUPPLY_KINDS.has(key)) {
      if (supply !== undefined) return false;
      supply = key;
    } else if (key === "update") {
      // One key carries the modify, so a second one is not a shape this can see.
      modify = true;
    } else {
      return false;
    }
  }

  if (supply === undefined) return false;
  if (vacate === "delete" && supply === "connectOrCreate") return false;
  if (!modify) return true;
  return childHeld || (vacate === undefined && supply === "connect");
}

const unsupportedCombination = (active: readonly string[]) => ({
  issues: [
    {
      message: `Unsupported to-one operation combination: ${active.join(", ")}`,
    },
  ],
});

function enforceCompositionLattice<Output>(
  result: StandardSchemaV1.Result<Output>,
  operationKeys: readonly string[],
  childHeld: boolean,
  exactlyOne: boolean
): StandardSchemaV1.Result<Output> {
  if (result.issues) return result;
  const output = result.value;
  if (!isRecord(output)) return result;

  const active: string[] = [];
  for (const key of operationKeys) {
    const value = output[key];
    if (value !== undefined && value !== false) active.push(key);
  }
  if (exactlyOne) {
    if (active.length === 1) return result;
    // Two intents is the SAME fact the lattice already has a sentence for, so it
    // keeps that sentence. Zero is the fact only this mode can state.
    return active.length === 0
      ? {
          issues: [
            {
              message: `Missing to-one operation: expected exactly one of ${operationKeys.join(", ")}`,
            },
          ],
        }
      : unsupportedCombination(active);
  }
  if (isAcceptedComposition(active, childHeld)) return result;
  return unsupportedCombination(active);
}

/**
 * Validate the underlying object once, then enforce to-one operation compatibility on
 * its canonical output. `false` remains a no-op for boolean mutation verbs.
 *
 * `childHeld` names the relation DIRECTION, because the two directions accept
 * different compositions (see the two `…CompositionMutation` types). The create root
 * passes no value for it: that surface owns no vacate and no `update`, so no
 * composition is spellable there and the flag has nothing to decide.
 *
 * `composition` names the RULE. `exactlyOne` narrows this owner for the direct
 * polymorphic edge, whose payload writes one atomic `(type, id)` pair and carries the
 * discriminator inside each verb: an empty payload names no target for a membership
 * the model may require, and two intents name two. Both were refused before this mode
 * existed — the first by a union that had no empty member, the second by hand-spelled
 * exclusivity — and both are refused here now, in this owner's voice.
 *
 * The counting validator is built HERE, before the schema object exists, and no
 * property of a constructed schema is ever redefined (validation Rule 4). That is not
 * a style preference: `v.union` and the lazy records capture a member's
 * `~standard.validate` at construction, so a validator patched onto a schema after the
 * fact is a validator some readers hold the un-patched version of.
 */
export function toOneMutationSchema<
  Entries extends object,
  const Options extends ObjectOptions | undefined = undefined,
  const ChildHeld extends boolean = false,
  const Composition extends ToOneMutationComposition = "lattice",
>(
  entries: Entries,
  options?: Options,
  childHeld?: ChildHeld,
  composition?: Composition
): ToOneMutationSchema<Entries, Options, ChildHeld, Composition> {
  const base = v.object(entries, options);
  const operationKeys = Object.keys(entries);
  const baseValidate = base["~standard"].validate;
  const isChildHeld = childHeld === true;
  const isExactlyOne = composition === "exactlyOne";
  const validate: typeof baseValidate = (value, validationOptions) =>
    enforceCompositionLattice(
      baseValidate(value, validationOptions),
      operationKeys,
      isChildHeld,
      isExactlyOne
    );

  const schema = {
    ...base,
    "~standard": {
      version: 1 as const,
      vendor: "viborm" as const,
      validate,
      // The lattice is not expressible in JSON Schema and never was, so the converter
      // is the base object's — reached through it rather than rebuilt, which keeps it
      // lazy for a self-referential relation.
      get jsonSchema() {
        return base["~standard"].jsonSchema;
      },
    },
  };
  Object.defineProperty(schema, " vibInferred", {
    value: undefined,
    enumerable: false,
  });

  return schema as ToOneMutationSchema<
    Entries,
    Options,
    ChildHeld,
    Composition
  >;
}
