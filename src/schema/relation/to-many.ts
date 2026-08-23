// `s.toMany` — the other of the two relation factories.
//
// The factory states the SLOT CARDINALITY (many) and its argument states the
// TARGET DOMAIN. A model-target collection is junction-capable and an empty
// collection is `[]`, so there is no `.optional()` here and no `.unique()`
// anywhere: the paired slot cardinality owns remote uniqueness.

import {
  type ExactVariantOptions,
  type NormalizedManyEntries,
  normalizeVariantEntries,
  type VariantGetterMap,
  type VariantMapGuard,
  type VariantOptions,
  type VariantToManyRelation,
  variantToManyTerminal,
} from "./polymorphic";
import {
  createTargetSettlement,
  normalizeJunctionAction,
  normalizeJunctionToken,
  normalizeRelationName,
  refuseRelationInput,
} from "./terminal";
import type {
  AnyRelation,
  Getter,
  GetterOnly,
  JunctionReferentialAction,
  ModelToManyState,
  OrdinaryJunctionOverrides,
  RelationInternal,
  Replace,
} from "./types";

// =============================================================================
// TERMINAL CAPABILITY SURFACE
// =============================================================================

/**
 * A model-target collection slot.
 *
 * The junction overrides are independent, meaningful facts rather than stages of
 * one all-or-nothing value, so any subset may override its canonical default.
 * Exactly one endpoint owns all supplied overrides; the other endpoint supplies
 * none and consumes the mirrored resolved view. Whether these overrides belong
 * on the resolved physical owner is one full-schema topology rule, not a second
 * type-level guess — which is why they are offered before the inverse graph
 * exists and why the state does not carry them as a public type parameter.
 */
export type ModelToManyRelation<State> = {
  readonly "~": RelationInternal<State>;
  name<const Name extends string>(
    name: Name
  ): ModelToManyRelation<Replace<State, { readonly name: Name }>>;
  through(table: string): ModelToManyRelation<State>;
  source(token: string): ModelToManyRelation<State>;
  target(token: string): ModelToManyRelation<State>;
  onDelete(action: JunctionReferentialAction): ModelToManyRelation<State>;
  onUpdate(action: JunctionReferentialAction): ModelToManyRelation<State>;
};

// =============================================================================
// PRIVATE TERMINAL
// =============================================================================

class ModelToMany {
  private readonly state: ModelToManyState;
  private readonly internal: RelationInternal<ModelToManyState>;

  constructor(state: ModelToManyState) {
    this.state = Object.freeze(state);
    this.internal = Object.freeze({
      state: this.state,
      settleTarget: createTargetSettlement(() => this.state.target.getter),
    });
  }

  name(name: string): ModelToMany {
    return new ModelToMany({
      ...this.state,
      name: normalizeRelationName("s.toMany", name),
    });
  }

  through(table: string): ModelToMany {
    return this.withJunction({
      ...this.state.junction,
      table: normalizeJunctionToken("through", table),
    });
  }

  source(token: string): ModelToMany {
    return this.withJunction({
      ...this.state.junction,
      source: normalizeJunctionToken("source", token),
    });
  }

  target(token: string): ModelToMany {
    return this.withJunction({
      ...this.state.junction,
      target: normalizeJunctionToken("target", token),
    });
  }

  onDelete(action: JunctionReferentialAction): ModelToMany {
    return this.withJunction({
      ...this.state.junction,
      onDelete: normalizeJunctionAction("onDelete", action),
    });
  }

  onUpdate(action: JunctionReferentialAction): ModelToMany {
    return this.withJunction({
      ...this.state.junction,
      onUpdate: normalizeJunctionAction("onUpdate", action),
    });
  }

  private withJunction(junction: OrdinaryJunctionOverrides): ModelToMany {
    return new ModelToMany({
      ...this.state,
      junction: Object.freeze(junction),
    });
  }

  get "~"(): RelationInternal<ModelToManyState> {
    return this.internal;
  }
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Declare a slot that holds a COLLECTION.
 *
 * The map overload is declared first so a variant map is never swallowed by the
 * broad getter overload. Dispatch examines only the argument representation and
 * never invokes a getter.
 */
export function toMany<
  const Entries extends VariantGetterMap,
  const Options extends VariantOptions<Entries> | undefined = undefined,
>(
  variants: Entries & VariantMapGuard<Entries>,
  options?: Options & ExactVariantOptions<Options, Entries>
): VariantToManyRelation<{
  readonly kind: "relation";
  readonly cardinality: "many";
  readonly target: {
    readonly kind: "variants";
    readonly entries: NormalizedManyEntries<Entries>;
  };
}>;
export function toMany<const G>(getter: G & GetterOnly<G>): G extends Getter
  ? ModelToManyRelation<{
      readonly kind: "relation";
      readonly cardinality: "many";
      readonly target: { readonly kind: "model"; readonly getter: G };
    }>
  : never;
export function toMany(target: unknown, options?: unknown): AnyRelation {
  if (typeof target === "function") {
    // biome-ignore lint/complexity/noArguments: distinguishes omission from explicit undefined without changing the factory's public arity
    if (arguments.length > 1) {
      refuseRelationInput(
        "s.toMany",
        "options",
        "A model-target relation takes exactly one argument"
      );
    }
    return new ModelToMany({
      kind: "relation",
      cardinality: "many",
      target: { kind: "model", getter: target },
    });
  }
  return variantToManyTerminal({
    kind: "relation",
    cardinality: "many",
    target: {
      kind: "variants",
      entries: normalizeVariantEntries("s.toMany", target, options),
    },
  });
}
